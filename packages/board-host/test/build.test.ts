// The bundle (H4, design 1.3): build.mjs builds once into a temporary folder; its layout, its natives, its fonts, its manifest,
// that it is tldraw's and React's development build (licence decision), then the built process itself: it starts (page, tldraw,
// fonts, natives) to "board host ready" with nothing on stdout, and refuses AIWB_BOARDHOST_DOM=jsdom (not shipped) with code 3.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { FONT_FACES } from "@aiwb/board-tl/model/fonts.ts";

const pkg = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let tmp = "", out = "", bundle = "";

before(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aiwb-boardhost-build-")));
  out = path.join(tmp, "dist");
  bundle = path.join(out, "boardhost.mjs");
  await promisify(execFile)(process.execPath, [path.join(pkg, "build.mjs"), "--out", out, "--version", "1.2.3"], { cwd: pkg, timeout: 120_000 });
});
after(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

test("the layout: the bundle, the manifest, the 16 fonts, the natives found from the bundle, no jsdom", () => {
  assert.ok(fs.statSync(bundle).size > 1_000_000);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, "manifest.json"), "utf8")), { version: "1.2.3", os: process.platform, arch: process.arch });
  assert.equal(FONT_FACES.length, 16);
  for (const f of FONT_FACES) assert.ok(fs.statSync(path.join(out, "assets", "fonts", f.file)).size > 10_000, f.file);
  const req = createRequire(bundle);
  const skia = req.resolve("skia-canvas");
  assert.ok(skia.startsWith(path.join(out, "node_modules", "skia-canvas") + path.sep), skia);
  assert.ok(fs.statSync(path.join(out, "node_modules", "skia-canvas", "lib", "skia.node")).size > 10_000_000);
  const resvg = req.resolve("@resvg/resvg-js");
  assert.ok(resvg.startsWith(path.join(out, "node_modules", "@resvg", "resvg-js") + path.sep), resvg);
  // its platform package, found from resvg-js as its index.js requires it
  const platform = fs.readdirSync(path.join(out, "node_modules", "@resvg")).filter((n) => n.startsWith("resvg-js-"));
  assert.equal(platform.length, 1, String(platform));
  const native = createRequire(resvg).resolve(`@resvg/${platform[0]}`);
  assert.ok(native.endsWith(".node") && native.startsWith(out), native);
  assert.ok(!fs.existsSync(path.join(out, "node_modules", "jsdom")));
  assert.throws(() => req.resolve("jsdom"), /Cannot find module/);
});

test("the development build of tldraw and React", () => {
  const text = fs.readFileSync(bundle, "utf8");
  assert.ok(!text.includes("process.env.NODE_ENV"), "NODE_ENV is defined at build time");
  assert.ok(!/NODE_ENV\s*[:=]\s*"production"/.test(text));
  // React's development-only code (its production build has none of these checks)
  assert.ok(text.includes("validateDOMNesting"));
});

const CONFIG = JSON.stringify({
  // a server that does not exist (the discard port, closed): the process prepares, then tries to connect
  address: "https://127.0.0.1:9", fingerprint: "00", secret: "not-a-real-secret-4711",
  clientId: "6f1c2a3b-1d2e-4f5a-8b6c-7d8e9f0a1b2c", instanceId: "i_build_test",
});

/** Starts the built process with the configuration line; resolves when `until` matches its stderr (then kills it) or it exits. */
function start(env: Record<string, string>, until?: RegExp): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    // (cwd: the temporary folder, so no node_modules of the repository is on the lookup path of a bare require)
    const p = spawn(process.execPath, [bundle], { cwd: tmp, env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { p.kill("SIGKILL"); reject(new Error(`no end in 30 s; stderr: ${stderr}`)); }, 30_000);
    p.stdout.on("data", (d) => { stdout += d; });
    p.stderr.on("data", (d) => { stderr += d; if (until?.test(stderr)) p.kill("SIGKILL"); });
    p.on("exit", (code) => { clearTimeout(timer); resolve({ stdout, stderr, code }); });
    p.stdin.on("error", () => {});
    p.stdin.write(CONFIG + "\n");
  });
}

test("the built process starts: page, tldraw, fonts, natives; nothing on stdout", async () => {
  const r = await start({ AIWB_BOARDHOST_DOM: "" }, /board host ready: linkedom, 16 fonts, \d+ ms\n/);
  assert.match(r.stderr, /board host ready: linkedom, 16 fonts, \d+ ms/);
  assert.equal(r.stdout, "");
});

test("AIWB_BOARDHOST_DOM=jsdom without jsdom beside the bundle: exit 3 with the reason, no stack", async () => {
  const r = await start({ AIWB_BOARDHOST_DOM: "jsdom" });
  assert.equal(r.code, 3);
  assert.equal(r.stderr, "cannot start the board host: AIWB_BOARDHOST_DOM=jsdom but jsdom is not installed next to the bundle\n");
  assert.equal(r.stdout, "");
});
