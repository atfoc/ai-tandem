// Checks a built desktop app (a macOS "AI Whiteboard.app" or a Windows "AI Whiteboard" folder) for the target it was built for. It
// reads headers and files in Node and uses no macOS tool, so a Windows folder is checked as well on Linux as on a Mac. Run by
// scripts/build-app.sh after electron-builder; exit 0 when every check holds, 1 with one sentence per problem, 2 for a bad call.
//
//   node scripts/check-build.mjs <app or folder> --os darwin|win32 --arch arm64|x64 --version <v> --headless <dir>
//
// <dir> is the build's own copy of the headless writer (desktop/build/headless), which electron-builder copied into the app.
// What it checks (plans/cross-platform-build/PLAN.md, D8):
//   - the window's executable, the server and skia.node are executables of the target (Mach-O cpu type / PE machine type);
//   - the server holds the version (the build stamps it into the Go binary), unless the version is "dev";
//   - the folder holds no server of the other operating system (no ai-whiteboard.exe in a bundle, no ai-whiteboard in a Windows folder);
//   - headless.mjs, manifest.json and engine/engine.mjs are byte for byte the build's copy (on Windows skia.node too: nothing signs it);
//   - the manifest's version is the version and its os/arch the target; the web build in the app carries the version;
//   - Electron's RunAsNode fuse is on (the server runs the headless writer with the app's Electron as Node);
//   - macOS: Info.plist's CFBundleVersion is the version. (The signature is checked by build-app.sh with codesign, which is a Mac's tool.)
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { targetProblem } from "./lib/binary-target.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const USAGE = "usage: node scripts/check-build.mjs <app or folder> --os darwin|win32 --arch arm64|x64 --version <v> --headless <dir>";
const SKIA = "engine/node_modules/skia-canvas/lib/skia.node";

/** The places of a target's parts inside the app. */
export function layout(app, os) {
  if (os === "darwin") {
    return {
      window: path.join(app, "Contents/MacOS/AI Whiteboard"),
      server: path.join(app, "Contents/MacOS/ai-whiteboard"),
      fuseTarget: app,
      resources: path.join(app, "Contents/Resources"),
      otherServer: "ai-whiteboard.exe",
    };
  }
  return {
    window: path.join(app, "AI Whiteboard.exe"),
    server: path.join(app, "ai-whiteboard.exe"),
    fuseTarget: path.join(app, "AI Whiteboard.exe"),
    resources: path.join(app, "resources"),
    otherServer: "ai-whiteboard",
  };
}

/** Parses the command line into { app, os, arch, version, headless }; throws an Error with a sentence on a bad call. */
export function parseArgs(argv) {
  const flags = new Map();
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) { rest.push(argv[i]); continue; }
    const k = argv[i].slice(2);
    if (!["os", "arch", "version", "headless"].includes(k)) throw new Error(`unknown flag ${argv[i]}`);
    if (argv[i + 1] === undefined || argv[i + 1].startsWith("--")) throw new Error(`${argv[i]} needs a value`);
    flags.set(k, argv[++i]);
  }
  if (rest.length !== 1) throw new Error("name the app or folder to check");
  for (const k of ["os", "arch", "version", "headless"]) if (!flags.has(k)) throw new Error(`--${k} is missing`);
  const os = flags.get("os");
  const arch = flags.get("arch");
  if (os !== "darwin" && os !== "win32") throw new Error(`--os ${os} is not darwin or win32`);
  if (arch !== "arm64" && arch !== "x64") throw new Error(`--arch ${arch} is not arm64 or x64`);
  return { app: rest[0], os, arch, version: flags.get("version"), headless: flags.get("headless") };
}

/** Every file under `dir` (not following links) whose name is `name`; paths relative to `dir`. */
export function findNamed(dir, name) {
  const found = [];
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name), path.join(rel, e.name));
      else if (e.name === name) found.push(path.join(rel, e.name));
    }
  };
  walk(dir, "");
  return found;
}

/** The CFBundleVersion of an XML Info.plist, or null. */
export function plistBundleVersion(xml) {
  const m = /<key>CFBundleVersion<\/key>\s*<string>([^<]*)<\/string>/.exec(xml);
  return m ? m[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&") : null;
}

/** Whether a JS file's text holds the version as a string literal (the page sets it with setPageVersion("<v>"), inlined by Metro). */
export function holdsVersion(js, version) {
  return js.includes(JSON.stringify(version)) || js.includes(`'${version}'`) || js.includes(`\`${version}\``);
}

/** Reads Electron's fuse wire with @electron/fuses, which electron-builder brings into desktop/node_modules. Returns true when RunAsNode is on. */
async function runAsNodeOn(fuseTarget) {
  const require = createRequire(path.join(here, "..", "desktop", "package.json"));
  const { getCurrentFuseWire, FuseV1Options } = require("@electron/fuses");
  const wire = await getCurrentFuseWire(fuseTarget);
  return wire[FuseV1Options.RunAsNode] === 0x31; // (the wire holds ASCII: '1' on, '0' off, 'r' removed)
}

/** Whether the file holds the bytes of `text`: read in chunks that overlap by the length of the text, so a server of tens of
 *  megabytes is never in memory whole. */
export function fileContains(file, text) {
  const needle = Buffer.from(text);
  if (needle.length === 0) return true;
  const chunk = Buffer.alloc(1 << 20);
  const fd = fs.openSync(file, "r");
  try {
    let kept = 0; // bytes of the end of the last chunk, kept at the start of the buffer for the next search
    for (;;) {
      const n = fs.readSync(fd, chunk, kept, chunk.length - kept, null);
      if (n === 0) return false;
      const have = kept + n;
      if (chunk.subarray(0, have).includes(needle)) return true;
      kept = Math.min(needle.length - 1, have);
      chunk.copy(chunk, 0, have - kept, have);
    }
  } finally {
    fs.closeSync(fd);
  }
}

function readText(file) {
  try { return fs.readFileSync(file, "utf8"); } catch { return null; }
}

/** Runs every check; resolves to the list of problems, in words (empty: all hold). `readFuse(fuseTarget)` -> Promise<boolean> is
 *  replaceable for a test with no Electron binary. */
export async function checkBuild({ app, os, arch, version, headless, readFuse = runAsNodeOn }) {
  const problems = [];
  const where = os === "darwin" ? "app" : "folder";
  if (!fs.existsSync(app) || !fs.statSync(app).isDirectory()) return [`the ${where} ${app} does not exist`];
  const target = { os, arch };
  const label = `${os === "darwin" ? "macOS" : "Windows"} ${arch}`;
  const l = layout(app, os);
  const rel = (f) => path.relative(app, f);

  // the executables of the target
  const exe = os === "win32" ? { dll: false } : {};
  for (const [what, file, extra] of [["the window's executable", l.window, exe], ["the server", l.server, exe]]) {
    if (!fs.existsSync(file)) problems.push(`${what} ${rel(file)} is missing from the ${where} (a ${label} build needs it)`);
    else { const p = targetProblem(file, { ...target, ...extra }); if (p) problems.push(`${what}: ${p}`); }
  }
  // the server was built with the version (a server of another build would say it is a different one than the page and the writer)
  if (version !== "dev" && fs.existsSync(l.server) && !fileContains(l.server, version)) {
    problems.push(`the server ${rel(l.server)} does not hold the version ${version}: it was not built with it (-X ai-whiteboard/internal/version.Version)`);
  }
  const inHeadless = path.join(l.resources, "headless");
  const skia = path.join(inHeadless, SKIA);
  if (!fs.existsSync(skia)) problems.push(`the native canvas ${rel(skia)} is missing from the ${where}`);
  else { const p = targetProblem(skia, { ...target, ...(os === "win32" ? { dll: true } : {}) }); if (p) problems.push(`the native canvas: ${p}`); }

  // no part of the other operating system
  for (const f of findNamed(app, l.otherServer)) {
    problems.push(`${rel(path.join(app, f))} is a server of the other operating system and has no place in a ${label} ${where}`);
  }

  // the headless writer arrived intact, and says what it is
  const same = ["headless.mjs", "manifest.json", "engine/engine.mjs", ...(os === "win32" ? [SKIA] : [])];
  // (macOS signs the native canvas, which rewrites it: it is checked by header and by codesign; Windows is not signed)
  for (const f of same) {
    const a = path.join(headless, f);
    const b = path.join(inHeadless, f);
    if (!fs.existsSync(b)) { if (f !== SKIA) problems.push(`headless/${f} is missing from the ${where}`); continue; }
    if (!fs.existsSync(a)) { problems.push(`the build's own headless copy has no ${f} to compare with (${a})`); continue; }
    if (!fs.readFileSync(a).equals(fs.readFileSync(b))) problems.push(`headless/${f} in the ${where} is not the build's copy: electron-builder did not put it in intact`);
  }
  const manifestText = readText(path.join(inHeadless, "manifest.json"));
  if (manifestText !== null) {
    let m;
    try { m = JSON.parse(manifestText); } catch { problems.push("headless/manifest.json in the " + where + " is not JSON"); }
    if (m) {
      if (m.version !== version) problems.push(`headless/manifest.json says version ${JSON.stringify(m.version)}, the build's version is ${version}`);
      if (m.os !== os || m.arch !== arch) problems.push(`headless/manifest.json says ${m.os}/${m.arch}, the target is ${os}/${arch}`);
    }
  }

  // the web build carries the version
  const web = path.join(l.resources, "web");
  const jsDir = path.join(web, "_expo/static/js");
  if (!fs.existsSync(path.join(web, "index.html"))) problems.push(`the web build (${rel(web)}/index.html) is missing from the ${where}`);
  else {
    let hit = false;
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (!hit && e.name.endsWith(".js") && holdsVersion(fs.readFileSync(p, "utf8"), version)) hit = true;
      }
    };
    if (fs.existsSync(jsDir)) walk(jsDir);
    if (!hit) problems.push(`the web build in the ${where} does not carry the version ${version} (no script of ${rel(jsDir)} holds it)`);
  }

  // RunAsNode
  if (fs.existsSync(l.fuseTarget)) {
    try {
      if (!(await readFuse(l.fuseTarget))) problems.push(`the RunAsNode fuse of Electron is off in ${l.fuseTarget}: the server could not run the headless writer with the app's Electron as Node (ELECTRON_RUN_AS_NODE has no effect). Do not flip it off in desktop/electron-builder.yml or in an afterPack hook`);
    } catch (e) {
      problems.push(`cannot read the RunAsNode fuse of ${l.fuseTarget}: ${e.message}`);
    }
  }

  // macOS: the bundle's version
  if (os === "darwin") {
    const xml = readText(path.join(app, "Contents/Info.plist"));
    if (xml === null) problems.push("Contents/Info.plist is missing from the app");
    else {
      const v = plistBundleVersion(xml);
      if (v !== version) problems.push(`Contents/Info.plist has CFBundleVersion ${v === null ? "none" : JSON.stringify(v)}, the build's version is ${version}`);
    }
  }
  return problems;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (e) { console.error(`${e.message}\n${USAGE}`); process.exit(2); }
  const problems = await checkBuild(opts);
  if (problems.length) {
    console.error(`the ${opts.os === "darwin" ? "macOS" : "Windows"} ${opts.arch} build ${opts.app} fails ${problems.length === 1 ? "a check" : problems.length + " checks"}:`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(`checks passed: ${opts.app} is a ${opts.os === "darwin" ? "macOS" : "Windows"} ${opts.arch} build of ${opts.version}`);
}
