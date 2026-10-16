// The built bundle runs as the server will run it: `node headless.mjs` with the configuration on stdin. Without the engine's folder it
// ends with code 3 and says why; a bad configuration does too; and the manifest names the build.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.join(here, "..");
let out = "";
const SECRET = "s3cr3t-Value-0123456789";

before(() => {
  out = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "aiwb-headless-"));
  const b = spawnSync(process.execPath, [path.join(pkg, "build.mjs"), "--out", out, "--os", process.platform, "--arch", process.arch, "--version", "1.2.3"], { cwd: out, encoding: "utf8" });
  assert.equal(b.status, 0, b.stderr + b.stdout);
});
after(() => { fs.rmSync(out, { recursive: true, force: true }); });

const runBundle = (stdin: string) => spawnSync(process.execPath, [path.join(out, "headless.mjs")], { cwd: out, input: stdin, encoding: "utf8", timeout: 30_000 });

test("the build is one file and a manifest", () => {
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, "manifest.json"), "utf8")), { version: "1.2.3", os: process.platform, arch: process.arch });
  assert.deepEqual(fs.readdirSync(out).sort(), ["engine", "headless.mjs", "manifest.json"]);
  for (const f of ["engine.mjs", "fonts", path.join("node_modules", "skia-canvas", "lib", "skia.node")]) assert.ok(fs.existsSync(path.join(out, "engine", f)), f);
  assert.match(fs.readFileSync(path.join(out, "headless.mjs"), "utf8"), /createRequire/);
});

test("a bad target is refused", () => {
  const b = spawnSync(process.execPath, [path.join(pkg, "build.mjs"), "--out", path.join(out, "x"), "--os", "plan9"], { encoding: "utf8" });
  assert.notEqual(b.status, 0);
});

test("without @aiwb/board-engine/node the build fails and says so", () => {
  // build.mjs copied where only esbuild resolves, so the engine's module cannot be found
  const lone = path.join(out, "lone");
  fs.mkdirSync(path.join(lone, "node_modules"), { recursive: true });
  fs.symlinkSync(path.dirname(path.dirname(fileURLToPath(import.meta.resolve("esbuild")))), path.join(lone, "node_modules", "esbuild"));
  fs.copyFileSync(path.join(pkg, "build.mjs"), path.join(lone, "build.mjs"));
  const b = spawnSync(process.execPath, [path.join(lone, "build.mjs"), "--out", path.join(lone, "dist")], { cwd: lone, encoding: "utf8" });
  assert.equal(b.status, 1, b.stderr);
  assert.match(b.stderr, /@aiwb\/board-engine\/node does not resolve/);
  assert.ok(!fs.existsSync(path.join(lone, "dist")));
});

test("with the engine's folder missing, the bundle prints why and exits 3", () => {
  fs.renameSync(path.join(out, "engine"), path.join(out, "engine.off"));
  const r = runBundle(JSON.stringify({
    address: "127.0.0.1:1", fingerprint: "AA", secret: SECRET, clientId: "6f1f1c3e-8a4b-4c55-9d0e-2b7a8c9d0e1f", instanceId: "i",
  }) + "\n");
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stderr, /cannot start the board engine: the engine's folder .* does not exist/);
  assert.ok(!r.stderr.includes(SECRET) && !r.stdout.includes(SECRET));
  assert.equal(r.stdout, "");
});

test("a bad configuration, or none, exits 3", () => {
  assert.equal(runBundle("{nope\n").status, 3);
  const none = runBundle("");
  assert.equal(none.status, 3);
  assert.match(none.stderr, /no configuration on stdin/);
});
