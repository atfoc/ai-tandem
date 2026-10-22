// Tests scripts/check-build.mjs on fake apps and folders made of tiny synthetic headers (Mach-O, PE): no real binary, no Electron,
// no build. Run: node --test scripts/test/*.test.mjs   (about a second)
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { checkBuild, fileContains, findNamed, holdsVersion, layout, parseArgs, plistBundleVersion } from "../check-build.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const VERSION = "v1-2-gabc-dirty";
const MACHO_CPU = { arm64: 0x0100000c, x64: 0x01000007 };
const PE_MACHINE = { arm64: 0xaa64, x64: 0x8664 };

const macho = (arch) => { const b = Buffer.alloc(64); b.writeUInt32LE(0xfeedfacf, 0); b.writeUInt32LE(MACHO_CPU[arch], 4); return b; };
const fat = (archs) => {
  const b = Buffer.alloc(8 + archs.length * 20);
  b.writeUInt32BE(0xcafebabe, 0); b.writeUInt32BE(archs.length, 4);
  archs.forEach((a, i) => b.writeUInt32BE(MACHO_CPU[a], 8 + i * 20));
  return b;
};
const pe = (arch, dll = false) => {
  const b = Buffer.alloc(0x200);
  b.write("MZ", 0, "latin1"); b.writeUInt32LE(0x80, 0x3c); b.write("PE\0\0", 0x80, "latin1");
  b.writeUInt16LE(PE_MACHINE[arch], 0x84); b.writeUInt16LE(0x0022 | (dll ? 0x2000 : 0), 0x80 + 22);
  return b;
};

function put(file, bytes) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); }

const dirs = [];
after_all();
function after_all() { process.on("exit", () => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); }); }

/** A fake build for a target: { app, headless }. `o` overrides: window, server, skia (Buffers), version (what the parts say),
 *  manifest (object merged into the manifest), serverVersion (what the server holds), webVersion, plistVersion, extra (files to add: path -> Buffer), drop (paths to remove). */
function fake(target, o = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aiwb-cb-"));
  dirs.push(dir);
  const { os: tos, arch } = target;
  const headless = path.join(dir, "build-headless");
  const app = path.join(dir, tos === "darwin" ? "AI Whiteboard.app" : "AI Whiteboard");
  const l = layout(app, tos);
  const v = o.version ?? VERSION;
  const skia = o.skia ?? (tos === "darwin" ? macho(arch) : pe(arch, true));
  const manifest = JSON.stringify({ version: v, os: tos, arch, ...(o.manifest ?? {}) }, null, 2) + "\n";
  const parts = { "headless.mjs": "export {};\n", "manifest.json": manifest, "engine/engine.mjs": "// engine\n" };
  for (const [f, text] of Object.entries(parts)) { put(path.join(headless, f), text); put(path.join(l.resources, "headless", f), text); }
  const skiaRel = "engine/node_modules/skia-canvas/lib/skia.node";
  put(path.join(headless, skiaRel), skia);
  put(path.join(l.resources, "headless", skiaRel), skia);
  put(l.window, o.window ?? (tos === "darwin" ? macho(arch) : pe(arch)));
  // (the Go linker's -X puts the version into the binary as plain bytes: here they follow the header)
  put(l.server, Buffer.concat([o.server ?? (tos === "darwin" ? macho(arch) : pe(arch)), Buffer.from(`\0some strings\0${o.serverVersion ?? v}\0more\0`)]));
  put(path.join(l.resources, "web/index.html"), "<html></html>");
  put(path.join(l.resources, "web/_expo/static/js/web/index-1.js"), `a(),(0,c.setPageVersion)(${JSON.stringify(o.webVersion ?? v)}),b()`);
  put(path.join(l.resources, "web/_expo/static/js/web/other.js"), "nothing");
  if (tos === "darwin") put(path.join(app, "Contents/Info.plist"), `<?xml version="1.0"?><plist><dict>\n<key>CFBundleVersion</key>\n<string>${o.plistVersion ?? v}</string>\n</dict></plist>`);
  for (const [f, b] of Object.entries(o.extra ?? {})) put(path.join(app, f), b);
  for (const f of o.drop ?? []) fs.rmSync(path.join(app, f), { recursive: true, force: true });
  return { app, headless, target };
}

const MAC = { os: "darwin", arch: "arm64" };
const MAC_X = { os: "darwin", arch: "x64" };
const WIN = { os: "win32", arch: "x64" };
const WIN_A = { os: "win32", arch: "arm64" };
const fuseOn = async () => true;
const run = (b, readFuse = fuseOn, version = VERSION) => checkBuild({ app: b.app, ...b.target, version, headless: b.headless, readFuse });
const has = (problems, text) => problems.some((p) => p.includes(text));

test("a complete build of each of the four targets has no problem", async () => {
  for (const t of [MAC, MAC_X, WIN, WIN_A]) assert.deepEqual(await run(fake(t)), [], `${t.os}/${t.arch}`);
});

test("a window, a server or a native canvas of the wrong processor, the wrong kind or the wrong OS is named", async () => {
  assert.ok(has(await run(fake(MAC, { window: macho("x64") })), "the window's executable: "));
  assert.ok(has(await run(fake(MAC_X, { server: macho("arm64") })), "the server: "));
  assert.ok(has(await run(fake(MAC, { server: fat(["arm64", "x64"]) })), "fat Mach-O"));
  assert.ok(has(await run(fake(MAC, { skia: pe("arm64", true) })), "the native canvas: "));
  assert.ok(has(await run(fake(WIN, { window: pe("arm64") })), "the window's executable: "));
  assert.ok(has(await run(fake(WIN_A, { server: macho("arm64") })), "the server: "));
  assert.ok(has(await run(fake(WIN, { skia: pe("x64") })), "not a DLL"), "skia.node is a DLL, not an executable");
  assert.ok(has(await run(fake(WIN, { window: pe("x64", true) })), "a PE DLL, not an executable"));
  assert.ok(has(await run(fake(WIN, { skia: macho("arm64") })), "the native canvas: "));
});

test("a missing window, server, native canvas, web build or Info.plist is a problem", async () => {
  assert.ok(has(await run(fake(MAC, { drop: ["Contents/MacOS/ai-whiteboard"] })), "the server Contents/MacOS/ai-whiteboard is missing"));
  assert.ok(has(await run(fake(WIN, { drop: ["AI Whiteboard.exe"] })), "the window's executable AI Whiteboard.exe is missing"));
  assert.ok(has(await run(fake(WIN, { drop: ["resources/headless/engine/node_modules"] })), "the native canvas"));
  assert.ok(has(await run(fake(WIN, { drop: ["resources/web/index.html"] })), "web build"));
  assert.ok(has(await run(fake(MAC, { drop: ["Contents/Info.plist"] })), "Info.plist is missing"));
  assert.deepEqual(await checkBuild({ app: "/nonexistent/x", ...WIN, version: VERSION, headless: "/nonexistent/h" }), ["the folder /nonexistent/x does not exist"]);
});

test("a server of the other operating system anywhere in the build is a problem", async () => {
  assert.ok(has(await run(fake(MAC, { extra: { "Contents/MacOS/ai-whiteboard.exe": pe("arm64") } })), "other operating system"));
  assert.ok(has(await run(fake(WIN, { extra: { "ai-whiteboard": macho("x64") } })), "other operating system"));
  assert.ok(has(await run(fake(WIN, { extra: { "resources/deep/er/ai-whiteboard": macho("x64") } })), "resources/deep/er/ai-whiteboard"));
  assert.deepEqual(await run(fake(WIN, { extra: { "ai-whiteboard.exe.txt": "x", "AI Whiteboard.exe.config": "x" } })), []);
});

test("headless parts that are not the build's copy, or whose manifest disagrees, are named", async () => {
  const a = fake(WIN);
  fs.writeFileSync(path.join(a.app, "resources/headless/engine/engine.mjs"), "// another\n");
  assert.ok(has(await run(a), "headless/engine/engine.mjs"));
  const b = fake(WIN);
  fs.writeFileSync(path.join(b.app, "resources/headless/engine/node_modules/skia-canvas/lib/skia.node"), pe("x64", true).subarray(0, 0x100));
  assert.ok(has(await run(b), "skia.node in the folder is not the build's copy"), "unsigned on Windows: byte for byte");
  const c = fake(MAC);
  fs.writeFileSync(path.join(c.app, "Contents/Resources/headless/engine/node_modules/skia-canvas/lib/skia.node"), macho("arm64").subarray(0, 40));
  assert.deepEqual(await run(c), [], "signed on the Mac: the file differs and only its header is checked");
  assert.ok(has(await run(fake(WIN, { version: "old" })), "manifest.json says version \"old\""), "(and the web build says old too)");
  assert.ok(has(await run(fake(MAC, { manifest: { arch: "x64" } })), "manifest.json says darwin/x64, the target is darwin/arm64"));
  assert.ok(has(await run(fake(WIN, { manifest: { os: "darwin" } })), "says darwin/x64, the target is win32/x64"));
  assert.ok(has(await run(fake(MAC, { drop: ["Contents/Resources/headless/headless.mjs"] })), "headless/headless.mjs is missing"));
  const d = fake(WIN);
  fs.rmSync(path.join(d.headless, "headless.mjs"));
  assert.ok(has(await run(d), "build's own headless copy has no headless.mjs"));
});

test("the version must be in the web build and in Info.plist", async () => {
  assert.ok(has(await run(fake(WIN, { webVersion: "dev" })), "does not carry the version"));
  assert.ok(has(await run(fake(MAC, { plistVersion: "dev" })), "CFBundleVersion \"dev\""));
  assert.ok(has(await run(fake(MAC, { drop: ["Contents/Resources/web/_expo"] })), "does not carry the version"));
});

test("the server must hold the version, unless the version is dev", async () => {
  for (const t of [MAC, WIN]) {
    const problems = await run(fake(t, { serverVersion: "v0-old" }));
    assert.ok(has(problems, "does not hold the version " + VERSION), `${t.os}: ${problems}`);
    assert.equal(problems.length, 1);
  }
  // a dev build stamps no version that can be looked for
  assert.deepEqual(await run(fake(WIN, { version: "dev", serverVersion: "dev" }), fuseOn, "dev"), []);
  assert.deepEqual(await run(fake(WIN, { version: "dev", serverVersion: "something else" }), fuseOn, "dev"), []);
});

test("fileContains finds the text anywhere, also across the edge of a chunk, and not when it is absent", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aiwb-cb-"));
  dirs.push(dir);
  const file = path.join(dir, "big.bin");
  const needle = "v9-9-gdeadbee-dirty";
  const CHUNK = 1 << 20;
  for (const at of [0, 100, CHUNK - 5, CHUNK - needle.length, CHUNK, CHUNK * 2 + 7, CHUNK * 3 - 1]) {
    const b = Buffer.alloc(CHUNK * 3 + 100, 0x61);
    b.write(needle, at, "latin1");
    fs.writeFileSync(file, b);
    assert.equal(fileContains(file, needle), true, `at ${at}`);
  }
  fs.writeFileSync(file, Buffer.alloc(CHUNK * 3, 0x61));
  assert.equal(fileContains(file, needle), false);
  fs.writeFileSync(file, needle.slice(0, -1));
  assert.equal(fileContains(file, needle), false);
  fs.writeFileSync(file, "");
  assert.equal(fileContains(file, needle), false);
});

test("the RunAsNode fuse off, or unreadable, is a problem; the fuse is read from the right file", async () => {
  assert.ok(has(await run(fake(WIN), async () => false), "RunAsNode fuse of Electron is off"));
  assert.ok(has(await run(fake(MAC), async () => { throw new Error("no sentinel"); }), "cannot read the RunAsNode fuse"));
  const seen = [];
  const m = fake(MAC), w = fake(WIN);
  await run(m, async (f) => { seen.push(f); return true; });
  await run(w, async (f) => { seen.push(f); return true; });
  assert.deepEqual(seen, [m.app, path.join(w.app, "AI Whiteboard.exe")]);
});

test("the real fuse reader, on a file with Electron's sentinel", async (t) => {
  const desktop = path.join(here, "..", "..", "desktop");
  let fuses;
  try { fuses = createRequire(path.join(desktop, "package.json"))("@electron/fuses"); } catch { t.skip("desktop/node_modules is not installed"); return; }
  for (const [state, on] of [["1", true], ["0", false]]) {
    const b = fake(WIN, { extra: { "AI Whiteboard.exe": Buffer.concat([pe("x64"), Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX"), Buffer.from([1, 8]), Buffer.from(state + "10110r1", "latin1")]) } });
    const problems = await checkBuild({ app: b.app, ...b.target, version: VERSION, headless: b.headless });
    assert.equal(problems.length === 0, on, `RunAsNode ${state}: ${problems.join("; ")}`);
  }
  assert.ok(fuses.getCurrentFuseWire);
});

test("parseArgs takes the five arguments and names what is wrong", () => {
  const ok = ["app", "--os", "win32", "--arch", "x64", "--version", "v1", "--headless", "h"];
  assert.deepEqual(parseArgs(ok), { app: "app", os: "win32", arch: "x64", version: "v1", headless: "h" });
  assert.deepEqual(parseArgs(["--headless", "h", "--version", "v1", "--arch", "arm64", "--os", "darwin", "A.app"]).app, "A.app");
  assert.throws(() => parseArgs([]), /name the app or folder/);
  assert.throws(() => parseArgs(ok.slice(0, 7)), /--headless is missing/);
  assert.throws(() => parseArgs([...ok, "--bogus", "1"]), /unknown flag --bogus/);
  assert.throws(() => parseArgs([...ok.slice(0, 8), "--version"]), /--headless needs a value/);
  assert.throws(() => parseArgs([...ok.slice(0, 7), "--headless"]), /--headless needs a value/);
  assert.throws(() => parseArgs(ok.map((x) => (x === "win32" ? "windows" : x))), /not darwin or win32/);
  assert.throws(() => parseArgs(ok.map((x) => (x === "x64" ? "x86" : x))), /not arm64 or x64/);
  assert.throws(() => parseArgs([...ok, "second"]), /name the app or folder/);
});

test("plistBundleVersion, holdsVersion and findNamed", () => {
  assert.equal(plistBundleVersion("<key>CFBundleVersion</key>\n\t<string>v1-&amp;</string>"), "v1-&");
  assert.equal(plistBundleVersion("<key>CFBundleShortVersionString</key><string>1</string>"), null);
  assert.ok(holdsVersion(`x("v1")`, "v1") && holdsVersion("x('v1')", "v1") && !holdsVersion("x('v10')", "v1") && !holdsVersion("v1", "v1"));
  const b = fake(WIN, { extra: { "a/b/target": "x", "target": "x" } });
  assert.deepEqual(findNamed(b.app, "target").sort(), ["a/b/target", "target"]);
});
